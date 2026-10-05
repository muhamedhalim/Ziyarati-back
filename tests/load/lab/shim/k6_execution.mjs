const S = globalThis.__LT;
export default {
  scenario: { get name() { return S.scenarioName; }, get startTime() { return S.startTime; }, get iterationInTest() { return S.iter++; } },
  test: { abort: (m) => { throw new Error(`test.abort: ${m}`); } },
  vu: {},
};
