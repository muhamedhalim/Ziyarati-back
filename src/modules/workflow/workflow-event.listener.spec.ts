import { CustomerBirthdayEvent } from '../../events/customer.events';
import { WorkflowEventListener } from './workflow-event.listener';

describe('WorkflowEventListener — occurrence guard', () => {
  const T1 = 'tenant-1';
  let workflows: {
    findActiveByTrigger: jest.Mock;
    evaluateConditions: jest.Mock;
    createRunWithOutbox: jest.Mock;
    hasRunForOccurrence: jest.Mock;
  };
  let listener: WorkflowEventListener;

  const wf = (id: string) => ({
    id,
    conditions: undefined,
    actions: [{ type: 'WHATSAPP', recipientType: 'CUSTOMER', config: {} }],
  });

  beforeEach(() => {
    workflows = {
      findActiveByTrigger: jest.fn().mockResolvedValue([wf('w1')]),
      evaluateConditions: jest.fn().mockReturnValue(true),
      createRunWithOutbox: jest.fn().mockResolvedValue({ id: 'run-1' }),
      hasRunForOccurrence: jest.fn().mockResolvedValue(false),
    };
    listener = new WorkflowEventListener(
      workflows as never,
      { getCorrelationId: () => 'corr-1' } as never,
    );
  });

  it("customer.birthday: loads the tenant's active birthday workflows and starts one run per workflow", async () => {
    await listener.onCustomerBirthday(
      new CustomerBirthdayEvent(T1, 'cust-1', '2026-03-14'),
    );

    expect(workflows.findActiveByTrigger).toHaveBeenCalledWith(
      T1,
      'customer.birthday',
    );
    expect(workflows.createRunWithOutbox).toHaveBeenCalledWith(
      T1,
      expect.objectContaining({ id: 'w1' }),
      {
        customerId: 'cust-1',
        occurrenceDate: '2026-03-14',
        occurrenceKey: 'cust-1:2026-03-14',
      },
      'corr-1',
    );
  });

  it('checks the once-per-occurrence guard for the SAME tenant, workflow and customer:date key', async () => {
    await listener.onCustomerBirthday(
      new CustomerBirthdayEvent(T1, 'cust-1', '2026-03-14'),
    );
    expect(workflows.hasRunForOccurrence).toHaveBeenCalledWith(
      T1,
      'w1',
      'cust-1:2026-03-14',
    );
  });

  it('does NOT start a second run when this occurrence was already greeted (a re-run of the sweep)', async () => {
    workflows.hasRunForOccurrence.mockResolvedValue(true);

    await listener.onCustomerBirthday(
      new CustomerBirthdayEvent(T1, 'cust-1', '2026-03-14'),
    );

    expect(workflows.createRunWithOutbox).not.toHaveBeenCalled();
  });

  it('guards per workflow: one already-greeted workflow does not suppress another', async () => {
    workflows.findActiveByTrigger.mockResolvedValue([wf('w1'), wf('w2')]);
    workflows.hasRunForOccurrence.mockImplementation(
      (_t: string, workflowId: string) => Promise.resolve(workflowId === 'w1'),
    );

    await listener.onCustomerBirthday(
      new CustomerBirthdayEvent(T1, 'cust-1', '2026-03-14'),
    );

    expect(workflows.createRunWithOutbox).toHaveBeenCalledTimes(1);
    expect(workflows.createRunWithOutbox.mock.calls[0][1].id).toBe('w2');
  });

  it('leaves every request-driven event unaffected: no occurrence guard is consulted', async () => {
    await listener.onAppointmentCreated({
      tenantId: T1,
      appointmentId: 'appt-1',
      customerId: 'cust-1',
      staffId: 'staff-1',
      branchId: 'branch-1',
      startAt: new Date('2026-03-14T10:00:00Z'),
    } as never);

    expect(workflows.hasRunForOccurrence).not.toHaveBeenCalled();
    expect(workflows.createRunWithOutbox).toHaveBeenCalledTimes(1);
  });
});
