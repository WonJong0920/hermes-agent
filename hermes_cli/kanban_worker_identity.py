"""Worker-fingerprint comparison helpers shared by Kanban dispatch paths."""

from typing import Optional


def composite_fingerprint_recycled(recorded: str, current: Optional[str]) -> bool:
    """Return True unless epochs match and both positive start times agree within shared tolerance."""
    from gateway.status import start_time_fingerprints_match

    try:
        recorded_epoch, recorded_start = recorded.split("|", 1)
        current_epoch, current_start = (current or "").split("|", 1)
        start_times = int(recorded_start), int(current_start)
        return (recorded_epoch != current_epoch or min(start_times) <= 0 or
                not start_time_fingerprints_match(*start_times))
    except (AttributeError, TypeError, ValueError):
        return True
