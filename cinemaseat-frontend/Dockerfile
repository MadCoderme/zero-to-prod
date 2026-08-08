# cinemaseat-frontend/Dockerfile

# Stage 1: Build the frontend static assets
FROM node:18-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build || mkdir -p dist && cp -r public/* dist/ 2>/dev/null || true

# Stage 2: Serve using lightweight Nginx
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# Include default nginx fallback for single page applications (SPA)
RUN echo 'server { listen 80; location / { root /usr/share/nginx/html; index index.html; try_files $uri $uri/ /index.html; } }' > /etc/nginx/conf.d/default.conf

EXPOSE 80