#!/usr/bin/env python3
"""
Example: Telegram Channel Handler

This demonstrates how to create a Python channel handler for Telegram.
The handler communicates with the Jonas agent via JSON-RPC over stdio.

Dependencies (requirements.txt):
python-telegram-bot==20.7

Config (config.json):
{
  "requiredSecrets": ["TELEGRAM_BOT_TOKEN"],
  "mode": "polling",
  "pollInterval": 3
}

Usage:
1. Create channel via channel_create MCP tool
2. Set TELEGRAM_BOT_TOKEN via channel_set_value
3. Enable and start the channel via dashboard
"""

import sys
import json
import asyncio
from typing import Dict, Any, Optional

# Note: In production, this would be imported from the base handler
# For this example, we inline the base class


class PythonChannelHandler:
    """Base class for Python channel handlers."""

    def __init__(self):
        self.config: Dict[str, Any] = {}
        self.secrets: Dict[str, str] = {}
        self._running = False

    async def on_start(self) -> None:
        """Override: Start webhook/polling."""
        pass

    async def on_stop(self) -> None:
        """Override: Cleanup resources."""
        pass

    async def on_send(self, channel_id: str, text: str) -> None:
        """Override: Send message to platform."""
        pass

    async def notify_message_received(self, channel_id: str, message: str) -> None:
        """Send incoming message to agent."""
        notification = {
            "jsonrpc": "2.0",
            "method": "message_received",
            "params": {"channel_id": channel_id, "message": message},
        }
        await self._send_stdout(notification)

    async def _send_stdout(self, obj: Dict[str, Any]) -> None:
        """Send JSON-RPC message to stdout."""
        line = json.dumps(obj) + "\n"
        sys.stdout.write(line)
        sys.stdout.flush()

    async def _handle_request(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Handle incoming JSON-RPC request."""
        method = request.get("method")
        params = request.get("params", {})
        req_id = request.get("id")

        try:
            if method == "initialize":
                self.config = params.get("config", {})
                self.secrets = params.get("secrets", {})
                return {"jsonrpc": "2.0", "id": req_id, "result": {"status": "ready"}}

            elif method == "start":
                await self.on_start()
                self._running = True
                return {"jsonrpc": "2.0", "id": req_id, "result": {"status": "started"}}

            elif method == "stop":
                await self.on_stop()
                self._running = False
                return {"jsonrpc": "2.0", "id": req_id, "result": {"status": "stopped"}}

            elif method == "send":
                channel_id = params.get("channel_id")
                text = params.get("text")
                if not channel_id or not text:
                    raise ValueError("Missing channel_id or text")
                await self.on_send(channel_id, text)
                return {"jsonrpc": "2.0", "id": req_id, "result": {"status": "sent"}}

            else:
                raise ValueError(f"Unknown method: {method}")

        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32603, "message": str(e)},
            }

    async def run(self) -> None:
        """Main event loop."""
        loop = asyncio.get_event_loop()

        while True:
            try:
                line = await loop.run_in_executor(None, sys.stdin.readline)
                if not line:
                    break

                line = line.strip()
                if not line:
                    continue

                request = json.loads(line)
                response = await self._handle_request(request)
                await self._send_stdout(response)

            except json.JSONDecodeError as e:
                sys.stderr.write(f"Invalid JSON: {e}\n")
                sys.stderr.flush()
            except Exception as e:
                sys.stderr.write(f"Error: {e}\n")
                sys.stderr.flush()


# Telegram-specific implementation
class TelegramChannelHandler(PythonChannelHandler):
    """Telegram channel handler using polling."""

    def __init__(self):
        super().__init__()
        self.application = None
        self.bot_token: Optional[str] = None

    async def on_start(self) -> None:
        """Initialize Telegram bot and start polling."""
        from telegram.ext import Application, MessageHandler, filters

        self.bot_token = self.secrets.get("TELEGRAM_BOT_TOKEN")
        if not self.bot_token:
            raise ValueError("Missing TELEGRAM_BOT_TOKEN in secrets")

        # Create application
        self.application = Application.builder().token(self.bot_token).build()

        # Register message handler
        self.application.add_handler(
            MessageHandler(
                filters.TEXT & ~filters.COMMAND, self._handle_telegram_message
            )
        )

        # Start polling in background
        await self.application.initialize()
        await self.application.start()
        asyncio.create_task(self._poll_loop())

        sys.stderr.write("Telegram bot started\n")
        sys.stderr.flush()

    async def on_stop(self) -> None:
        """Stop Telegram bot."""
        if self.application:
            await self.application.stop()
            await self.application.shutdown()
            self.application = None

        sys.stderr.write("Telegram bot stopped\n")
        sys.stderr.flush()

    async def on_send(self, channel_id: str, text: str) -> None:
        """Send message to Telegram chat."""
        if not self.application:
            raise RuntimeError("Bot not initialized")

        try:
            chat_id = int(channel_id)
            await self.application.bot.send_message(chat_id=chat_id, text=text)
            sys.stderr.write(f"Sent message to {chat_id}\n")
            sys.stderr.flush()
        except Exception as e:
            sys.stderr.write(f"Failed to send message: {e}\n")
            sys.stderr.flush()
            raise

    async def _handle_telegram_message(self, update, context) -> None:
        """Handle incoming Telegram message."""
        if not update.message or not update.message.text:
            return

        chat_id = str(update.message.chat_id)
        text = update.message.text

        # Forward to agent
        await self.notify_message_received(chat_id, text)

    async def _poll_loop(self) -> None:
        """Run Telegram polling loop."""
        if not self.application:
            return

        # Start polling
        await self.application.updater.start_polling(
            poll_interval=self.config.get("pollInterval", 3),
            allowed_updates=["message"],
        )

        # Wait until stopped
        while self._running:
            await asyncio.sleep(1)

        # Stop polling
        await self.application.updater.stop()


def main():
    """Entry point."""
    handler = TelegramChannelHandler()
    asyncio.run(handler.run())


if __name__ == "__main__":
    main()
