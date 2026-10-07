import { AgentRouterService } from './agent-router.service';

describe('AgentRouterService — intent keywords (Step 11)', () => {
  const route = async (text: string) => {
    const agents = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    const service = new AgentRouterService(agents as never);
    return (await service.route('t1', text)).role;
  };

  it.each([
    ['I want to book an appointment', 'BOOKING'],
    ['أبغى أحجز موعد', 'BOOKING'],
    ['أريد إلغاء الموعد', 'BOOKING'],
    ['how much is the price', 'BILLING'],
    ['كم سعر الكشف؟', 'BILLING'],
    ['أحتاج فاتورة', 'BILLING'],
    ['I have a pain in my back', 'MEDICAL_FAQ'],
    ['عندي ألم في الظهر', 'MEDICAL_FAQ'],
    ['أريد تقديم شكوى', 'REVIEW'],
    ['عندي مشكلة في الدخول', 'SUPPORT'],
    ['حدث بياناتي من فضلك', 'CRM'],
  ])('%s -> %s', async (text, role) => {
    expect(await route(text)).toBe(role);
  });

  it('returns no role for small talk', async () => {
    expect(await route('السلام عليكم')).toBeNull();
  });
});
