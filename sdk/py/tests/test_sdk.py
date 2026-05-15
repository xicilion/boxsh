import unittest
from . import test_client, test_helpers, test_overlay, test_terminal


def load_tests(loader: unittest.TestLoader, tests: unittest.TestSuite, pattern: str):
    suite = unittest.TestSuite()
    for module in (test_client, test_overlay, test_terminal, test_helpers):
        suite.addTests(loader.loadTestsFromModule(module))
    return suite


if __name__ == "__main__":
    unittest.main()