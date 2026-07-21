import unittest
import tempfile
from pathlib import Path
from todo import TaskManager, main

class TestTaskManager(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "tasks.json"
        self.manager = TaskManager(file_path=self.db_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_add_task(self):
        task = self.manager.add_task("Buy groceries")
        self.assertEqual(task["id"], 1)
        self.assertEqual(task["title"], "Buy groceries")
        self.assertFalse(task["done"])
        self.assertTrue(self.db_path.exists())

    def test_add_multiple_tasks_increments_id(self):
        task1 = self.manager.add_task("Task 1")
        task2 = self.manager.add_task("Task 2")
        self.assertEqual(task1["id"], 1)
        self.assertEqual(task2["id"], 2)

    def test_add_empty_title_raises_error(self):
        with self.assertRaises(ValueError):
            self.manager.add_task("   ")

    def test_list_tasks(self):
        self.manager.add_task("Task 1")
        self.manager.add_task("Task 2")
        tasks = self.manager.list_tasks()
        self.assertEqual(len(tasks), 2)

    def test_complete_task(self):
        task = self.manager.add_task("Task 1")
        res = self.manager.complete_task(task["id"])
        self.assertTrue(res)
        
        # Verify persistence and status
        updated_manager = TaskManager(file_path=self.db_path)
        self.assertTrue(updated_manager.list_tasks()[0]["done"])

    def test_complete_nonexistent_task(self):
        res = self.manager.complete_task(999)
        self.assertFalse(res)

    def test_complete_already_completed_task(self):
        task = self.manager.add_task("Task 1")
        self.manager.complete_task(task["id"])
        res = self.manager.complete_task(task["id"])
        self.assertFalse(res)

class TestCLI(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "tasks.json"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_cli_add_and_list(self):
        # We can pass custom sys.argv args to main if needed, but here we test main logic
        self.assertEqual(main(["add", "Test CLI"]), 0)
        self.assertEqual(main(["list"]), 0)

if __name__ == "__main__":
    unittest.main()
