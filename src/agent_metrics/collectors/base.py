"""
Base collector class.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any
from ..models import CollectorStatus


class BaseCollector(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        pass

    @abstractmethod
    def check_availability(self) -> str:
        pass

    @abstractmethod
    def collect(self, run_context: Dict[str, Any]) -> Dict[str, Any]:
        pass
