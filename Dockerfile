# Use Node.js 20 base image (Debian Bookworm)
FROM node:20-bookworm-slim

# Install Python 3 and pip — no poppler needed (PyMuPDF handles all PDF rendering)
# build-essential needed for any native Node addons (ws, bufferutil, etc.)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages
# pymupdf = pure-Python PDF page renderer (replaces pdftoppm)
# pdfplumber = pure-Python text extractor (replaces pdftotext/pdfinfo)
# pikepdf = fallback page counter
RUN pip3 install --break-system-packages anthropic reportlab pillow pymupdf pdfplumber pikepdf

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
