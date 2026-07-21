#!/usr/bin/env python3
import argparse
import json
import os
import sys
from pathlib import Path
from typing import List, Dict, Any, Optional

DEFAULT_DB_FILE = Path(__file__).parent / "tasks.json"

class TaskManager:
    def __init__(self, file_path: Path = DEFAULT_DB_FILE):
        self.file_path = Path(file_path)
        self.tasks: List[Dict[str, Any]] = self._load()

    def _load(self) -> List[Dict[str, Any]]:
        if not self.file_path.exists():
            return []
        try:
            with open(self.file_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return []

    def _save(self) -> None:
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.file_path.with_suffix(".tmp")
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(self.tasks, f, indent=2, ensure_ascii=False)
        os.replace(temp_path, self.file_path)

    def add_task(self, title: str) -> Dict[str, Any]:
        title = title.strip()
        if not title:
            raise ValueError("Task title cannot be empty.")
        
        next_id = max([t["id"] for t in self.tasks], default=0) + 1
        task = {
            "id": next_id,
            "title": title,
            "done": False
        }
        self.tasks.append(task)
        self._save()
        return task

    def list_tasks(self) -> List[Dict[str, Any]]:
        return self.tasks

    def complete_task(self, task_id: int) -> bool:
        for task in self.tasks:
            if task["id"] == task_id:
                if task["done"]:
                    return False  # Already completed
                task["done"] = True
                self._save()
                return True
        return False  # Not found

def main(args: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Simple CLI TODO List Manager")
    subparsers = parser.add_subparsers(dest="command", help="Available subcommands")

    # add subcommand
    add_parser = subparsers.add_parser("add", help="Add a new task")
    add_parser.add_argument("title", type=str, help="Task title")

    # list subcommand
    subparsers.add_parser("list", help="List all tasks")

    # complete subcommand
    complete_parser = subparsers.add_parser("complete", help="Mark a task as completed")
    complete_parser.add_argument("id", type=int, help="Task ID")

    parsed_args = parser.parse_args(args)

    manager = TaskManager()

    if parsed_args.command == "add":
        try:
            task = manager.add_task(parsed_args.title)
            print(f"Added task #{task['id']}: {task['title']}")
        except ValueError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1

    elif parsed_args.command == "list":
        tasks = manager.list_tasks()
        if not tasks:
            print("No tasks found.")
        else:
            for task in tasks:
                status = "[x]" if task["done"] else "[ ]"
                print(f"{status} #{task['id']}: {task['title']}")

    elif parsed_args.command == "complete":
        success = manager.complete_task(parsed_args.id)
        if success:
            print(f"Completed task #{parsed_args.id}")
        else:
            print(f"Error: Task #{parsed_args.id} not found or already completed.", file=sys.stderr)
            return 1
    else:
        parser.print_help()
        return 1

    return 0

if __name__ == "__main__":
    sys.exit(main())
