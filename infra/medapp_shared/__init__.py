"""
Code shared between CDK stacks and Lambda handlers (registry keys, item shapes, lifecycle rules).

Pure Python, no AWS SDK imports, so the same module can be unit-tested here and packaged into a
Lambda layer later without changes.
"""
