# Use Node.js 20 base image (Debian Bookworm)
FROM node:20-bookworm-slim

# Install Python 3, pip, and poppler-utils (for pdftoppm)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages
RUN pip3 install --break-system-packages anthropic reportlab pillow

WORKDIR /app

# Copy package files and install Node dependencies
COPY package*.json ./
RUN npm ci

# Copy all source files
COPY . .

# Build the app (compiles TypeScript + Vite frontend)
RUN npm run build

# Expose port
EXPOSE 5000

# Start the production server
CMD ["npm", "run", "start"]
