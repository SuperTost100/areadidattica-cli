FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY src ./src
USER node
CMD ["node", "src/main.ts"]
