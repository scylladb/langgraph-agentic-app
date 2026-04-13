#!/bin/bash

# Prompt for Groq API key (hidden input)
read -s -p "Groq API key: " groq_key
echo

# Update or add GROQ_API_KEY in .env file
if [ -f .env ] && grep -q "^GROQ_API_KEY=" .env; then
    sed -i "s|^GROQ_API_KEY=.*|GROQ_API_KEY=${groq_key}|" .env
else
    echo "GROQ_API_KEY=${groq_key}" >> .env
fi

echo "GROQ_API_KEY has been set in .env"