import { z } from 'zod';

/* Minimal Harbor adapter: expose only Zod, never a second renderer/runtime. */
const adapter = Object.freeze({ z, zodVersion: '4.6.7' });
if (typeof globalThis !== 'undefined') globalThis.UiSchema = adapter;
else if (typeof window !== 'undefined') window.UiSchema = adapter;
export default adapter;
