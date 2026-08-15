import { loadConfig } from '@syntra/core';
import { buildApp } from './app.js';

const config = loadConfig(process.env);
const app = await buildApp(config);

await app.listen({ port: config.port, host: '0.0.0.0' });
