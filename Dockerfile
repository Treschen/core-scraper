FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
RUN npx playwright install --with-deps
COPY . .
CMD ["node","/app/scrape-one.mjs"]
