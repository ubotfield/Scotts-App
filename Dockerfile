FROM node:20-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy all source files
COPY . .

# Build the frontend (Vite production build → dist/)
RUN npm run build

# Expose the port Cloud Run will use
EXPOSE 8080

# Start the Express server (serves API + built frontend)
ENV PORT=8080
CMD ["npx", "tsx", "server.ts"]
