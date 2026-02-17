#!/usr/bin/env python3
"""
Python Channel Handler Base Class

This is a template/base class for Python-based channel handlers.
Channel handlers communicate with the Node.js agent via stdio using JSON-RPC.

Protocol:
- Agent sends JSON-RPC requests over stdin
- Handler sends JSON-RPC responses/notifications over stdout
- All messages are newline-delimited JSON

Message Types:
1. initialize(config, secrets) -> handler ready
2. start() -> start webhook/polling
3. stop() -> cleanup
4. send(channel_id, text) -> send message to platform
5. message_received(channel_id, message) <- notification from handler to agent
"""

import sys
import json
import asyncio
from abc import ABC, abstractmethod
from typing import Dict, Any, Optional, Callable, Awaitable


class PythonChannelHandler(ABC):
    """
    Base class for Python channel handlers.

    Subclass this and implement the abstract methods to create a channel.
    """

    def __init__(self):
        self.config: Dict[str, Any] = {}
        self.secrets: Dict[str, str] = {}
        self.send_to_agent: Optional[Callable[[str, str], Awaitable[str]]] = None
        self._running = False

    @abstractmethod
    async def on_start(self) -> None:
        """
        Called when the channel should start.
        Initialize webhook server or start polling loop here.
        """
        pass

    @abstractmethod
    async def on_stop(self) -> None:
        """
        Called when the channel should stop.
        Cleanup resources here.
        """
        pass

    @abstractmethod
    async def on_send(self, channel_id: str, text: str) -> None:
        """
        Called when a message should be sent to the platform.

        Args:
            channel_id: Platform-specific channel/chat/user ID
            text: Message text to send
        """
        pass

    async def notify_message_received(self, channel_id: str, message: str) -> None:
        """
        Send incoming message to the agent.
        Call this when you receive a message from the platform.

        Args:
            channel_id: Platform-specific channel/chat/user ID
            message: Message text received
        """
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
        """Main event loop - read from stdin and process requests."""
        loop = asyncio.get_event_loop()

        # Read stdin line by line
        while True:
            try:
                line = await loop.run_in_executor(None, sys.stdin.readline)
                if not line:
                    break  # EOF

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


# Example Implementation (can be used as a template)
class ExampleChannelHandler(PythonChannelHandler):
    """
    Example channel handler demonstrating the interface.
    Replace this with your actual platform implementation.
    """

    async def on_start(self) -> None:
        sys.stderr.write("ExampleChannel: Starting...\n")
        sys.stderr.flush()
        # Start webhook server or polling loop here
        # For polling:
        # asyncio.create_task(self._poll_loop())

    async def on_stop(self) -> None:
        sys.stderr.write("ExampleChannel: Stopping...\n")
        sys.stderr.flush()
        # Cleanup resources

    async def on_send(self, channel_id: str, text: str) -> None:
        sys.stderr.write(f"ExampleChannel: Sending to {channel_id}: {text}\n")
        sys.stderr.flush()
        # Send message to platform API
        # Example: await self._api_send(channel_id, text)

    async def _poll_loop(self) -> None:
        """Example polling loop."""
        while self._running:
            # Poll platform for new messages
            # Example:
            # messages = await self._api_poll()
            # for msg in messages:
            #     await self.notify_message_received(msg.channel_id, msg.text)
            await asyncio.sleep(5)


def main():
    """Entry point - create handler and run."""
    handler = ExampleChannelHandler()
    asyncio.run(handler.run())


if __name__ == "__main__":
    main()
