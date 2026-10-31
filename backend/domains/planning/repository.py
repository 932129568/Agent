# -*- coding: utf-8 -*-
"""Single owner for plan/checkpoint paths and associated purge operations."""
import os
import re
import shutil

from ... import paths

_TASK_ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
TASK_ID_ERROR = 'task_id 非法（仅限字母数字 _ -，≤64）'


def safe_task_id(task_id):
    value = str(task_id or '').strip()
    if not _TASK_ID.match(value):
        raise ValueError(TASK_ID_ERROR)
    return value


def plans_dir():
    return os.path.join(paths.CONFIG_DIR, 'plans')


def checkpoints_dir():
    return os.path.join(paths.CONFIG_DIR, 'checkpoints')


def task_path(task_id):
    return os.path.join(plans_dir(), '%s.json' % safe_task_id(task_id))


def checkpoint_path(task_id):
    return os.path.join(checkpoints_dir(), safe_task_id(task_id))


def purge_associated(task_ids, logger=None):
    """Remove associated plan/checkpoint files with the legacy skip semantics."""
    removed = {'plans': 0, 'checkpoints': 0}
    plans_root = os.path.realpath(plans_dir())
    checkpoints_root = os.path.realpath(checkpoints_dir())
    for task_id in task_ids:
        value = str(task_id or '').strip()
        if not value:
            continue
        try:
            safe_id = safe_task_id(value)
        except ValueError:
            if logger:
                logger.warning('purge 跳过非法 task_id: %r', value)
            continue
        try:
            plan = task_path(safe_id)
            if os.path.exists(plan) and os.path.realpath(plan).startswith(plans_root + os.sep):
                os.remove(plan)
                removed['plans'] += 1
            checkpoint = checkpoint_path(safe_id)
            if os.path.isdir(checkpoint) and os.path.realpath(checkpoint).startswith(
                    checkpoints_root + os.sep):
                shutil.rmtree(checkpoint, ignore_errors=True)
                removed['checkpoints'] += 1
        except Exception as error:
            if logger:
                logger.warning('purge plan/ckpt %s 失败: %r', safe_id, error)
    return removed
