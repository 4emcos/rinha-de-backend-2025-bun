FROM oven/bun:1.1.13-slim

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY . ./

RUN bun i
RUN bun run build

CMD ["bun", "run", "start"]
