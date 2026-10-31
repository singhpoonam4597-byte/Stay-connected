# Connect backend — modular map (Phase D)

API routes are **unchanged**. Domain folders under `modules/` re-export existing root files.

## Layout

```
modules/
  auth/       → authRoutes, jwt, passwords
  users/      → users
  messages/   → messages, conversations
  groups/     → groups
  ai/         → ai
  settings/   → settings
  upload/     → upload
  realtime/   → chatHandler, presenceHandler
  shared/     → errorHandler, scale
  database/   → prisma
server.js     → imports from modules/index.js
```

Root `*.js` files remain the implementation (no behavior change).
Later migrations can move implementation into `modules/` without changing `/api/*` paths.

## Deploy

Render continues to run `node server.js` (or package.json start).
