import { mapMetaTemplateStatus } from './template-status.util';
import { WHATSAPP_TEMPLATE_STATUS } from './whatsapp.constants';

/**
 * This mapping is shared by the pull sync and the create-on-Meta response.
 * The case that matters most is the default: an unrecognised status must never
 * become `approved`, because `getSendableTemplate` treats `approved` as
 * unconditionally sendable.
 */
describe('mapMetaTemplateStatus', () => {
  it.each([
    ['APPROVED', WHATSAPP_TEMPLATE_STATUS.APPROVED],
    ['REJECTED', WHATSAPP_TEMPLATE_STATUS.REJECTED],
    ['PAUSED', WHATSAPP_TEMPLATE_STATUS.DISABLED],
    ['DISABLED', WHATSAPP_TEMPLATE_STATUS.DISABLED],
    ['PENDING', WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW],
    ['IN_APPEAL', WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW],
    ['PENDING_DELETION', WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW],
  ])('maps Meta %s → %s', (meta, expected) => {
    expect(mapMetaTemplateStatus(meta)).toBe(expected);
  });

  it('is case-insensitive (Meta has used both cases across API versions)', () => {
    expect(mapMetaTemplateStatus('approved')).toBe(WHATSAPP_TEMPLATE_STATUS.APPROVED);
  });

  it('never treats an unknown status as sendable, and reports it', () => {
    const onUnknown = jest.fn();
    expect(mapMetaTemplateStatus('LIMIT_EXCEEDED', onUnknown)).toBe(
      WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW,
    );
    expect(onUnknown).toHaveBeenCalledWith('LIMIT_EXCEEDED');
  });

  it('treats a missing status as pending rather than approved', () => {
    expect(mapMetaTemplateStatus(undefined)).toBe(WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW);
  });
});
