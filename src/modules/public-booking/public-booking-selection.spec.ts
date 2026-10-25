import { SESSION_UNSET } from '../ai-orchestrator/conversation-session.service';
import {
  branchSelectedPatch,
  clinicSelectedPatch,
  doctorSelectedPatch,
  servicesSelectedPatch,
  slotSelectedPatch,
} from './public-booking-selection';

describe('public booking selection patches', () => {
  it('a new clinic clears branch-dependent choices with the real clear sentinel, not undefined', () => {
    const p = clinicSelectedPatch('c1');
    expect(p).toEqual({
      selectedClinicId: 'c1',
      selectedBranchId: undefined,
      selectedDoctorId: SESSION_UNSET,
      selectedServiceIds: SESSION_UNSET,
      selectedStartAt: SESSION_UNSET,
    });
    // `undefined` would be dropped by the session service and preserve stale state.
    expect(p.selectedDoctorId).not.toBeUndefined();
    expect(p.selectedServiceIds).not.toBeUndefined();
    expect(p.selectedStartAt).not.toBeUndefined();
  });

  it('a single-branch clinic auto-selects its branch', () => {
    expect(clinicSelectedPatch('c1', 'b1').selectedBranchId).toBe('b1');
  });

  it('a branch change clears doctor, services and time', () => {
    expect(branchSelectedPatch('c1', 'b2')).toEqual({
      selectedClinicId: 'c1',
      selectedBranchId: 'b2',
      selectedDoctorId: SESSION_UNSET,
      selectedServiceIds: SESSION_UNSET,
      selectedStartAt: SESSION_UNSET,
    });
  });

  it('a doctor change clears the time; a slot or service pick clears nothing', () => {
    expect(doctorSelectedPatch('d1')).toEqual({ selectedDoctorId: 'd1', selectedStartAt: SESSION_UNSET });
    expect(slotSelectedPatch('2026-10-26T09:00:00Z')).toEqual({ selectedStartAt: '2026-10-26T09:00:00Z' });
    expect(servicesSelectedPatch(['s1'])).toEqual({ selectedServiceIds: ['s1'] });
  });
});
