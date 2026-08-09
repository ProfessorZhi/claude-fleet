"""
Base collector abstract class.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, Optional
from agent_metrics.models import CollectorStatus


class BaseCollector(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        pass

    def check_availability(self) -> str:
        return self.get_status()

    @abstractmethod
    def get_status(self) -> str:
        pass

    @abstractmethod
    def collect(self, run_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        pass
