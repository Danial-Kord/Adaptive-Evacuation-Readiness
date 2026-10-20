"""ADK package entry point so `adk web` and `adk run` discover `root_agent`."""

from . import schemas


def __getattr__(name: str):
    if name == "root_agent":
        from .agent import root_agent as _root_agent
        return _root_agent
    if name == "agent":
        from . import agent as _agent
        return _agent
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ["root_agent", "schemas"]
