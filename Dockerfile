FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data /app/uploads && chown -R node:node /app

USER node
EXPOSE 3100
CMD ["node", "server.js"]
