FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV HOST=0.0.0.0 PORT=5178 NODE_ENV=production
EXPOSE 5178
CMD ["node", "server/index.js"]
