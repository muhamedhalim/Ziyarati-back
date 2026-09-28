import { promisesHumanContact } from './human-contact-promise.util';

describe('promisesHumanContact', () => {
  it.each([
    'Someone from the clinic will contact you shortly.',
    'Our team will call you tomorrow morning.',
    "We'll reach out to you as soon as a slot opens up.",
    'A team member will get back to you with the details.',
    'The clinic will follow up with you about your insurance claim.',
    'A staff member will be in touch with you soon.',
    'We will call you back once we confirm with the doctor.',
  ])('matches an English promise of contact: %s', (text) => {
    expect(promisesHumanContact(text)).toBe(true);
  });

  it.each([
    'سيتواصل معك أحد أفراد فريق العيادة قريبًا.',
    'سنتصل بك غدًا لتأكيد الموعد.',
    'سيتابع معك فريق العيادة بخصوص طلبك.',
    'سيعاود الاتصال بك أحد الموظفين.',
  ])('matches an Arabic promise of contact: %s', (text) => {
    expect(promisesHumanContact(text)).toBe(true);
  });

  it.each([
    null,
    undefined,
    '',
    '   ',
    'How can I help you today?',
    'We will help you book an appointment.',
    'We can help you find a doctor nearby.',
    'You can contact the clinic at the number on our website.',
    'You can call us anytime during business hours.',
    'The doctor is available on Tuesdays and Thursdays.',
    'Your appointment is confirmed for tomorrow at 10am.',
    'سنساعدك في حجز موعدك الآن.',
    'يمكنك التواصل مع العيادة عبر الهاتف.',
  ])('does not match ordinary helpful text: %j', (text) => {
    expect(promisesHumanContact(text as string | null | undefined)).toBe(false);
  });
});
