# Ollama Setup Guide

This guide explains how to use Ollama for local LLM inference with Jonas.

## Quick Start

1. **Enable Ollama service in Docker Compose**

   Uncomment the `ollama` service in `docker-compose.yml`:
   ```yaml
   ollama:
     image: ollama/ollama:latest
     # ... rest of config
   ```

2. **Configure environment**

   Set these variables in your `.env`:
   ```bash
   MODEL_PROVIDER=ollama
   OLLAMA_BASE_URL=http://ollama:11434
   OLLAMA_MODEL=qwen2.5-coder:latest
   ```

3. **Start services**

   ```bash
   docker compose up -d
   ```

4. **Pull a model**

   ```bash
   docker compose exec ollama ollama pull qwen2.5-coder:latest
   ```

5. **Restart agent**

   ```bash
   docker compose restart agent
   ```

## Recommended Models

### For Coding Tasks
- **qwen2.5-coder:7b** - Fast, good for general coding (4.7GB)
- **qwen2.5-coder:14b** - Better quality, slower (8.9GB)
- **qwen2.5-coder:32b** - Highest quality (19GB, needs GPU)

### For General Assistant Tasks
- **llama3.2:3b** - Fast, lightweight (2GB)
- **llama3.1:8b** - Good balance (4.7GB)
- **mistral:7b** - Strong reasoning (4.1GB)

## GPU Support (NVIDIA)

For faster inference, enable GPU support:

1. Install NVIDIA Container Toolkit on your host
2. Uncomment GPU config in `docker-compose.yml`:
   ```yaml
   deploy:
     resources:
       reservations:
         devices:
           - driver: nvidia
             count: all
             capabilities: [gpu]
   ```

3. Restart: `docker compose up -d`

## Using External Ollama Instance

If you're running Ollama outside Docker:

1. Set `OLLAMA_BASE_URL` to your instance:
   ```bash
   OLLAMA_BASE_URL=http://192.168.1.100:11434
   ```

2. Comment out or remove the `ollama` service from `docker-compose.yml`

## Dashboard Configuration

You can also configure Ollama via the dashboard:

1. Navigate to `/model` in the dashboard
2. Select "Ollama (local models)"
3. Enter base URL and model name
4. Click "Refresh Models" to see available models
5. Save and restart the agent

## Switching Between Claude and Ollama

### Via Environment Variables

Edit `.env` and change `MODEL_PROVIDER`:
```bash
# Use Claude
MODEL_PROVIDER=claude

# Use Ollama
MODEL_PROVIDER=ollama
```

### Via Runtime Config

Create `/data/model-config.json`:
```json
{
  "provider": "ollama",
  "ollama": {
    "baseUrl": "http://ollama:11434",
    "model": "qwen2.5-coder:7b"
  }
}
```

### Via Dashboard

Use the web UI to switch providers without editing files.

**Note:** Restart the agent after changing providers.

## Managing Models

### List available models
```bash
docker compose exec ollama ollama list
```

### Pull a new model
```bash
docker compose exec ollama ollama pull llama3.2:3b
```

### Remove a model
```bash
docker compose exec ollama ollama rm llama3.2:3b
```

### Check disk usage
```bash
docker compose exec ollama du -sh /root/.ollama/models
```

## Performance Tips

1. **Use quantized models** - Models with `:7b` or `:3b` tags are quantized for speed
2. **Enable GPU** - Dramatically faster inference (10-50x)
3. **Increase memory** - Add `OLLAMA_MAX_LOADED_MODELS=2` to keep models in memory
4. **Use SSD storage** - Faster model loading

## Troubleshooting

### "Ollama API error (404)"
- Model not pulled yet. Run `ollama pull <model>`

### "Failed to connect to Ollama"
- Check service is running: `docker compose ps ollama`
- Check URL is correct in config

### "Out of memory"
- Use smaller model (3b or 7b)
- Reduce concurrent requests
- Enable swap on host

### Slow inference
- Enable GPU support
- Use smaller/quantized model
- Check CPU/memory usage: `docker stats`

## Cost Comparison

| Provider | Cost | Privacy | Speed | Quality |
|----------|------|---------|-------|---------|
| Claude Pro | $20/mo | Cloud | Fast | Excellent |
| Ollama (CPU) | Free | Local | Slow | Good |
| Ollama (GPU) | Free | Local | Fast | Good |

## Model Size Guide

| Model | Size | RAM Required | GPU VRAM | Use Case |
|-------|------|--------------|----------|----------|
| qwen2.5-coder:3b | 1.9GB | 4GB | 4GB | Quick tasks |
| qwen2.5-coder:7b | 4.7GB | 8GB | 8GB | General coding |
| qwen2.5-coder:14b | 8.9GB | 16GB | 16GB | Complex tasks |
| qwen2.5-coder:32b | 19GB | 32GB | 32GB | Production quality |

## Example Workflows

### Development with Local Models
```bash
# Use fast local model for development
MODEL_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5-coder:7b
```

### Production with Claude
```bash
# Use Claude for production quality
MODEL_PROVIDER=claude
AGENT_DEFAULT_MODEL=claude-sonnet-4-5-20250929
```

### Hybrid Setup
Use the dashboard to switch between providers based on task:
- Ollama for quick iterations and testing
- Claude for important or complex tasks

## Additional Resources

- [Ollama Model Library](https://ollama.com/library)
- [Ollama Docker Hub](https://hub.docker.com/r/ollama/ollama)
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
