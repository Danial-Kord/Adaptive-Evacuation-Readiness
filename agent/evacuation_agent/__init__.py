"""ADK package entry point so `adk web` and `adk run` discover `root_agent`."""

from .agent import root_agent

__all__ = ["root_agent"]
