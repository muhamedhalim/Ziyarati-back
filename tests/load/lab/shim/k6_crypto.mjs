import nodeCrypto from 'node:crypto';
export default { hmac: (alg, key, data, enc) => nodeCrypto.createHmac(alg, key).update(data).digest(enc), sha256: (d, e) => nodeCrypto.createHash('sha256').update(d).digest(e) };
