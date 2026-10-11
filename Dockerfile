# One image for the API and the worker, one for the web app. Both build from the workspace root.
FROM oven/bun:1.4 AS base
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json prisma.config.ts ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# Lifecycle scripts are skipped: `prepare` sets git hooks, which needs a git checkout.
RUN bun install --frozen-lockfile --ignore-scripts
COPY prisma prisma
COPY packages packages
# prisma generate reads DATABASE_URL from the config but never connects.
RUN DATABASE_URL=postgresql://build@localhost/build bunx --bun prisma generate

FROM base AS api
COPY apps/api apps/api
ENV NODE_ENV=production
# Bun reads tsconfig (decorator settings) from the working directory.
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["bun", "src/main.ts"]

FROM base AS web
COPY apps/web apps/web
# Next.js resolves rewrites at build time, so the API address is a build argument.
ARG API_URL=http://api:4000
ENV API_URL=$API_URL NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN bun run --cwd apps/web build
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/web", "start"]
