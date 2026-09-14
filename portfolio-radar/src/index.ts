import { createHandler } from './app.js';
Deno.serve(createHandler(Deno.env.toObject(), (task: Promise<unknown>) => EdgeRuntime.waitUntil(task)));
