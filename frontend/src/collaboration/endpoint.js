/* W5E1 deterministic, secret-free EndpointRef snapshots; no transport/network code. */
const COLLABORATION_SHA_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
];
function collaborationCanonical(value) {
  if (Array.isArray(value)) return value.map(collaborationCanonical);
  if (value && typeof value === 'object') {
    const result = {};
    Object.keys(value).sort().forEach(key => { result[key] = collaborationCanonical(value[key]); });
    return result;
  }
  return value;
}
function collaborationSha256(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(collaborationCanonical(value));
  const bytes = [...new TextEncoder().encode(text)];
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 4294967296), low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 255);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 255);
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array(64);
    for (let index = 0; index < 16; index++) {
      const at = offset + index * 4;
      words[index] = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index++) {
      const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let index = 0; index < 64; index++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + COLLABORATION_SHA_K[index] + words[index]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    [a,b,c,d,e,f,g,h].forEach((word, index) => { hash[index] = (hash[index] + word) >>> 0; });
  }
  return hash.map(word => word.toString(16).padStart(8, '0')).join('');
}
function collaborationAssertNoSecret(value) {
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, child]) => {
    if (/^(?:api[_-]?key|secret|password|authorization|bearer|token)$/i.test(key)) {
      throw new Error('ENDPOINT_SECRET_FORBIDDEN');
    }
    if (typeof child === 'string' && (/^sk-[A-Za-z0-9_-]{8,}/.test(child) || /^Bearer\s+/i.test(child) ||
        /ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}/.test(child))) {
      throw new Error('ENDPOINT_SECRET_FORBIDDEN');
    }
    collaborationAssertNoSecret(child);
  });
}
function collaborationValidateCredentialRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) ||
      !['provider-key', 'local-no-key', 'custom-provider-key'].includes(ref.kind) ||
      typeof ref.providerConfigDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(ref.providerConfigDigest) ||
      Object.keys(ref).some(key => !['kind', 'providerConfigDigest'].includes(key))) {
    throw new Error('ENDPOINT_SECRET_FORBIDDEN');
  }
  return ref;
}
class EndpointRef {
  constructor(options) {
    const source = options || {};
    for (const key of ['role', 'preset', 'baseUrlRef', 'model', 'credentialRef', 'prices', 'toolCapability', 'ctxWindow']) {
      if (source[key] === undefined) throw new Error('ENDPOINT_FIELD_MISSING:' + key);
    }
    if (!['cloud', 'local'].includes(source.role) || !source.model || !source.baseUrlRef ||
        !Number.isInteger(source.ctxWindow) || source.ctxWindow < 8192 || !Array.isArray(source.toolCapability)) {
      throw new Error('ENDPOINT_INCOMPATIBLE');
    }
    collaborationValidateCredentialRef(source.credentialRef);
    collaborationAssertNoSecret(source);
    const fields = { role: source.role, preset: source.preset, baseUrlRef: source.baseUrlRef,
      model: source.model, credentialRef: source.credentialRef, prices: source.prices,
      toolCapability: source.toolCapability.slice(), ctxWindow: source.ctxWindow };
    this.role = fields.role; this.preset = fields.preset; this.baseUrlRef = fields.baseUrlRef;
    this.model = fields.model; this.credentialRef = fields.credentialRef; this.prices = fields.prices;
    this.toolCapability = fields.toolCapability; this.ctxWindow = fields.ctxWindow;
    this.snapshotDigest = source.snapshotDigest || collaborationSha256(fields);
    Object.freeze(this.credentialRef); Object.freeze(this.prices); Object.freeze(this.toolCapability); Object.freeze(this);
  }
}
function collaborationEndpointSnapshot(role, snapshot, credentialRef) {
  if (!snapshot) throw new Error('ENDPOINT_SNAPSHOT_MISSING:' + role);
  const ref = credentialRef || { kind: role === 'cloud' ? 'provider-key' : 'local-no-key',
    providerConfigDigest: collaborationSha256({ preset: snapshot.preset, baseUrlRef: snapshot.baseUrlRef,
      model: snapshot.model, ctxWindow: snapshot.ctxWindow }) };
  return new EndpointRef({ role, preset: snapshot.preset, baseUrlRef: snapshot.baseUrlRef,
    model: snapshot.model, credentialRef: ref, prices: snapshot.prices,
    toolCapability: snapshot.toolCapability, ctxWindow: snapshot.ctxWindow });
}
function createCollaborationEndpoints(options) {
  const source = options || {};
  const cache = source.cache || {};
  const active = source.active || 'cloud';
  const cloud = active === 'cloud' ? source.currentCloud : cache.cloud;
  const local = active === 'local' ? source.currentLocal : cache.local;
  return Object.freeze({
    cloud: collaborationEndpointSnapshot('cloud', cloud, source.cloudCredentialRef),
    local: collaborationEndpointSnapshot('local', local, source.localCredentialRef),
  });
}
