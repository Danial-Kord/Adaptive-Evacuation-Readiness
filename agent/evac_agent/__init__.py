from . import schemas


def __getattr__(name: str):
    if name == "agent":
        from . import agent as _agent
        return _agent
    if name == "root_agent":
        from .agent import root_agent as _root_agent
        return _root_agent
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ["agent", "root_agent", "schemas"]
