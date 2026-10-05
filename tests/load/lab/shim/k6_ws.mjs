// A socket that immediately plays a happy-path Socket.IO conversation, so the AI flows run end to end.
export default {
  connect(url, params, fn) {
    const handlers = {}; const sent = [];
    const socket = {
      on: (e, h) => { handlers[e] = h; }, send: (m) => { sent.push(m); }, close: () => {}, setTimeout: () => {}, setInterval: () => {},
    };
    fn(socket);
    const m = handlers.message;
    if (m) { m('0{"sid":"x"}'); m('40/ai,{"sid":"y"}'); m('42/ai,["ai:connected",{"userId":"u"}]'); m('2'); m('42/ai,["ai:done",{"aiConversationId":"c"}]'); }
    globalThis.__LT.wsSent.push(...sent);
    return { status: 101 };
  },
};
