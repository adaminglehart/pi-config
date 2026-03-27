FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY server.ts .
EXPOSE 3000
CMD ["bun", "run", "server.ts"]
