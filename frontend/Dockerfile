FROM node:24-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm config set registry https://registry.npmjs.org/ \
    && npm ci --no-audit --no-fund

FROM node:24-alpine AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app ./

CMD ["npm", "start"]

FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./


