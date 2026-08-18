# Minimal secure Node.js container for Google Cloud Run
FROM node:20-alpine AS runner

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application files
COPY server.js ./
COPY index.html ./
COPY style.css ./
COPY app.js ./
COPY gemini-live.js ./

# Set environment
ENV NODE_ENV=production
ENV PORT=8080

# Cloud Run defaults to port 8080
EXPOSE 8080

# Run as non-root user
USER node

CMD ["node", "server.js"]
