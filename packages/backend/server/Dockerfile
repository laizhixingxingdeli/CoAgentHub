FROM node:22-alpine AS base

RUN npm install -g pnpm turbo@^2

FROM base AS build
WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm run build:api

EXPOSE 3001

CMD [ "pnpm", "start:api" ]

