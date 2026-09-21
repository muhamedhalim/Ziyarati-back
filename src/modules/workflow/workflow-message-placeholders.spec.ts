import {
  hasWorkflowPlaceholder,
  renderWorkflowMessage,
} from './workflow-message-placeholders';

describe('workflow message placeholders', () => {
  describe('hasWorkflowPlaceholder', () => {
    it('detects the two supported placeholders, tolerating inner whitespace', () => {
      expect(hasWorkflowPlaceholder('Hi {{customerName}}')).toBe(true);
      expect(hasWorkflowPlaceholder('From {{ clinicName }}')).toBe(true);
    });

    it('ignores plain text and unknown placeholders', () => {
      expect(hasWorkflowPlaceholder('Your appointment is booked.')).toBe(false);
      expect(hasWorkflowPlaceholder('Hi {{firstName}}')).toBe(false);
    });
  });

  describe('renderWorkflowMessage', () => {
    it('substitutes both values', () => {
      expect(
        renderWorkflowMessage('Hi {{customerName}}, from {{clinicName}}.', {
          customerName: 'Sara',
          clinicName: 'Al Noor',
        }),
      ).toBe('Hi Sara, from Al Noor.');
    });

    it('leaves any other {{placeholder}} exactly as authored', () => {
      expect(
        renderWorkflowMessage('{{customerName}} — {{other}}', {
          customerName: 'Sara',
          clinicName: 'Al Noor',
        }),
      ).toBe('Sara — {{other}}');
    });

    it('does not re-space an authored message when every value is present', () => {
      expect(
        renderWorkflowMessage('Hello  {{customerName}} !', {
          customerName: 'Sara',
          clinicName: 'Al Noor',
        }),
      ).toBe('Hello  Sara !');
    });

    it('drops a missing name and its dangling comma: "Happy Birthday, !" becomes "Happy Birthday!"', () => {
      expect(
        renderWorkflowMessage('Happy Birthday, {{customerName}}!', {
          clinicName: 'Al Noor',
        }),
      ).toBe('Happy Birthday!');
    });

    it('does the same for the Arabic comma', () => {
      expect(
        renderWorkflowMessage(
          'كل عام وأنت بخير، {{customerName}}! يتمنى لك فريق {{clinicName}} دوام الصحة.',
          { clinicName: 'النور' },
        ),
      ).toBe('كل عام وأنت بخير! يتمنى لك فريق النور دوام الصحة.');
    });

    it('never leaves a literal supported placeholder behind, even with no values at all', () => {
      const out = renderWorkflowMessage(
        'Dear {{customerName}}, welcome to {{clinicName}}.',
        {},
      );
      expect(out).not.toContain('{{');
    });
  });
});
