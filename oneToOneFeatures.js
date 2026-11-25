import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import p0 from './oneToOneFeatures.b64.0.js';
import p1 from './oneToOneFeatures.b64.1.js';
import p2 from './oneToOneFeatures.b64.2.js';
import p3 from './oneToOneFeatures.b64.3.js';
import p4 from './oneToOneFeatures.b64.4.js';
import p5 from './oneToOneFeatures.b64.5.js';

const b64 = p0 + p1 + p2 + p3 + p4 + p5;
const code = Buffer.from(b64, 'base64').toString('utf8');
const dest = new URL('./oneToOneFeatures.generated.js', import.meta.url);
writeFileSync(dest, code);
const mod = await import(pathToFileURL(dest.pathname).href + '?t=' + Date.now());
export const processOneToOneMaintenance = mod.processOneToOneMaintenance;
export const startOneToOneMaintenance = mod.startOneToOneMaintenance;
export const initOneToOneCallHandler = mod.initOneToOneCallHandler;
export default mod.default;
