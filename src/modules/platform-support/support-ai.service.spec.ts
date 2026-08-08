import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { ErrorCode } from '../../common/errors';
import {
  createMockDataSource,
  createMockRepository,
  MockDataSource,
  MockRepository,
} from '../../../test/utils/mock-factories';

import { SupportClinicResolver } from './support-clinic.resolver';
import { SupportAiService } from './support-ai.service';
import { QuerySupportDiagnosticsDto } from './dto/query-support-diagnostics.dto';

const TENANT_ID = '88888888-8888-4888-8888-888888888888';
const query = (over: Partial<QuerySupportDiagnosticsDto> = {}) =>
  Object.assign(new QuerySupportDiagnosticsDto(), over);

describe('SupportAiService', () => {
  let service: SupportAiService;
  let tenants: MockRepository;
  let dataSource: MockDataSource;

  beforeEach(async () => {
    tenants = createMockRepository();
    tenants.exists.mockResolvedValue(true);
    dataSource = createMockDataSource();
    dataSource.query = jest.fn(async (sql: string) => {
      if (/COUNT\(\*\)::int AS total\s+FROM ai_tool_calls/.test(sql)) return [{ total: 1 }];
      if (/FROM ai_tool_calls/.test(sql)) {
        return [
          {
            id: 'tc1',
            tool_name: 'book_appointment',
            status: 'FAILED',
            error: 'slot taken; ref https://api.example/slots/9?token=abc patient +966501234567',
            appointment_id: null,
            ai_conversation_id: 'conv-ext-1',
            conversation_id: 'conv-1',
            created_at: new Date('2026-08-01T10:00:00Z'),
            completed_at: new Date('2026-08-01T10:00:02Z'),
          },
        ];
      }
      if (/FROM ai_conversations/.test(sql)) {
        return [
          {
            channel: 'WHATSAPP',
            status: 'ACTIVE',
            count: 4,
            last_activity_at: new Date('2026-08-01T11:00:00Z'),
          },
        ];
      }
      if (/FROM handover_requests/.test(sql)) {
        return [
          {
            total: 3,
            pending: 1,
            resolved: 2,
            last_requested_at: new Date('2026-08-01T09:00:00Z'),
            last_resolved_at: new Date('2026-08-01T09:30:00Z'),
          },
        ];
      }
      return [];
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupportAiService,
        SupportClinicResolver,
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = moduleRef.get(SupportAiService);
  });

  it('returns tool calls, conversation activity and handover state', async () => {
    const result = await service.diagnostics(TENANT_ID, query());

    expect(Object.keys(result).sort()).toEqual(
      ['conversations', 'handovers', 'toolCalls', 'windowDays'].sort(),
    );
  });

  describe('tool calls', () => {
    it('returns the tool NAME and status, never the arguments or result payload', async () => {
      const { toolCalls } = await service.diagnostics(TENANT_ID, query());

      expect(toolCalls.data[0].toolName).toBe('book_appointment');
      expect(toolCalls.data[0].succeeded).toBe(false);
      expect(Object.keys(toolCalls.data[0]).sort()).toEqual(
        [
          'aiConversationId',
          'appointmentId',
          'completedAt',
          'conversationId',
          'createdAt',
          'failureReason',
          'id',
          'status',
          'succeeded',
          'toolName',
        ].sort(),
      );

      const listSql = dataSource.query.mock.calls.find(([s]: [string]) =>
        /SELECT id, tool_name/.test(s),
      )![0] as string;
      expect(listSql).not.toContain('arguments');
      expect(listSql).not.toContain('result');
    });

    it('sanitizes the tool failure reason — no URLs, tokens or phone numbers', async () => {
      const { toolCalls } = await service.diagnostics(TENANT_ID, query());

      const reason = toolCalls.data[0].failureReason!;
      expect(reason).toContain('slot taken');
      expect(reason).not.toContain('api.example');
      expect(reason).not.toContain('abc');
      expect(reason).not.toContain('966501234567');
    });

    it('links a successful tool call to the appointment it produced, for cross-diagnostic correlation', async () => {
      dataSource.query = jest.fn(async (sql: string) => {
        if (/COUNT\(\*\)::int AS total\s+FROM ai_tool_calls/.test(sql)) return [{ total: 1 }];
        if (/FROM ai_tool_calls/.test(sql)) {
          return [
            {
              id: 'tc2',
              tool_name: 'book_appointment',
              status: 'SUCCEEDED',
              error: null,
              appointment_id: 'appt-9',
              ai_conversation_id: null,
              conversation_id: null,
              created_at: new Date(),
              completed_at: new Date(),
            },
          ];
        }
        return [];
      });

      const { toolCalls } = await service.diagnostics(TENANT_ID, query());

      expect(toolCalls.data[0].succeeded).toBe(true);
      expect(toolCalls.data[0].appointmentId).toBe('appt-9');
      expect(toolCalls.data[0].failureReason).toBeNull();
    });

    it('is paginated and date-bounded like every other diagnostic history', async () => {
      await service.diagnostics(TENANT_ID, query({ days: 7, page: 3, limit: 5 }));

      const listCall = dataSource.query.mock.calls.find(([s]: [string]) =>
        /SELECT id, tool_name/.test(s),
      )!;
      expect(listCall[0]).toContain('created_at >= $2');
      expect(listCall[1]).toEqual(expect.arrayContaining([TENANT_ID, 5, 10]));
    });
  });

  describe('privacy and cost exclusion', () => {
    it('never touches the conversation transcript or the live session state', async () => {
      await service.diagnostics(TENANT_ID, query());

      for (const [sql] of dataSource.query.mock.calls) {
        expect(sql).not.toContain('ai_messages');
        expect(sql).not.toMatch(/\bsession\b/);
      }
    });

    it('never reads any AI cost, token or pricing column', async () => {
      const result = await service.diagnostics(TENANT_ID, query());

      for (const [sql] of dataSource.query.mock.calls) {
        for (const forbidden of ['cost_usd', 'cost_microusd', 'pricing_status', 'tokens']) {
          expect(sql).not.toContain(forbidden);
        }
      }
      const serialized = JSON.stringify(result).toLowerCase();
      expect(serialized).not.toContain('cost');
      expect(serialized).not.toContain('usd');
    });

    it('never selects handover reason or notes — free text about a live patient conversation', async () => {
      await service.diagnostics(TENANT_ID, query());

      const handoverSql = dataSource.query.mock.calls.find(([s]: [string]) =>
        /FROM handover_requests/.test(s),
      )![0] as string;
      expect(handoverSql).not.toContain('reason');
      expect(handoverSql).not.toContain('notes');
    });

    it('summarises conversations as counts by channel and state, never as individual sessions', async () => {
      const { conversations } = await service.diagnostics(TENANT_ID, query());

      expect(conversations).toEqual([
        {
          channel: 'WHATSAPP',
          status: 'ACTIVE',
          count: 4,
          lastActivityAt: '2026-08-01T11:00:00.000Z',
        },
      ]);
    });

    it('reports handover state so "the bot never escalated to us" is answerable', async () => {
      const { handovers } = await service.diagnostics(TENANT_ID, query());

      expect(handovers).toEqual({
        total: 3,
        pending: 1,
        resolved: 2,
        lastRequestedAt: '2026-08-01T09:00:00.000Z',
        lastResolvedAt: '2026-08-01T09:30:00.000Z',
      });
    });
  });

  it('exposes no re-execution path — a transactional tool call can never be re-run from here', () => {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter(
      (m) => m !== 'constructor',
    );
    for (const method of methods) {
      expect(method).not.toMatch(/execute|rerun|replay|retry|dispatch|invoke|book|cancel/i);
    }
  });

  it('404s an unknown clinic before querying', async () => {
    tenants.exists.mockResolvedValue(false);

    await expect(service.diagnostics(TENANT_ID, query())).rejects.toMatchObject({
      code: ErrorCode.TENANT_NOT_FOUND,
    });
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});
