FROM oven/bun:1.2-alpine

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY . .
RUN bun run build

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3011

EXPOSE 3011

CMD ["bun", "src/server/index.ts"]
