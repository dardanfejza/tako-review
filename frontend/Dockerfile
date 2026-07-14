# Frontend image — one Dockerfile, four targets (deps -> dev | build -> prod).
# See docs/superpowers/specs/2026-06-09-docker-local-environment-design.md §5.2.

# deps: install node_modules once, incl. the Linux esbuild/Rollup native binaries
# (package.json allowlists esbuild's build script via pnpm.onlyBuiltDependencies). Lockfile is v9.
FROM node:20-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# dev: Vite dev server with HMR. Source is bind-mounted at runtime and node_modules is a named
# volume (compose, §5.3) so the host folder can't shadow the Linux-built deps. `--host` is passed
# here (not baked into vite.config.ts) so a plain host-side `pnpm dev` still binds localhost-only.
FROM deps AS dev
COPY . .
CMD ["pnpm", "dev", "--host"]

# build: produce the static dist/ (tsc -b && vite build).
FROM deps AS build
COPY . .
RUN pnpm build

# prod: Caddy serving the built dist/ with the real prod CSP. Validate the Caddyfile at BUILD time
# so structural errors fail the build, not the running container (§5.4).
FROM caddy:2-alpine AS prod
COPY --from=build /app/dist /srv
COPY deploy/Caddyfile.docker /etc/caddy/Caddyfile
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# Run unprivileged. Caddy binds :8080 (unprivileged; see Caddyfile.docker) so no CAP_NET_BIND
# is needed; compose maps host 8080 -> container 8080. The base image ships a non-root `caddy`
# user/group; give it write to the data dirs Caddy needs (autosave config + state).
RUN mkdir -p /data /config && chown -R caddy:caddy /data /config /srv
USER caddy
