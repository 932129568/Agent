# -*- coding: utf-8 -*-
"""W5A expert package constants and structured errors (no executable package code)."""
import re

METADATA_PATHS = (
    '.codebuddy-plugin/plugin.json',
    '.workbuddy-plugin/plugin.json',
    'plugin.json',
)
SETTINGS_PATHS = (
    '.codebuddy-plugin/settings.json',
    '.workbuddy-plugin/settings.json',
    'settings.json',
)
ID_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{0,63}$')
VERSION_RE = re.compile(r'^\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,31})?$')
DIGEST_RE = re.compile(r'^[0-9a-f]{64}$')
TEXT_EXTENSIONS = {'.md', '.txt', '.json', '.csv', '.yaml', '.yml'}
SECRET_NAMES = {'.env', 'credentials.json', 'secrets.json', 'id_rsa', 'id_dsa'}

DEFAULT_LIMITS = {
    'maxPackageBytes': 32 * 1024 * 1024,
    'maxFileBytes': 1024 * 1024,
    'maxFiles': 512,
    'maxDepth': 8,
    'maxAgents': 64,
    'maxSkills': 64,
    'maxResources': 256,
    'maxMetadataBytes': 64 * 1024,
    'maxResourceBytes': 256 * 1024,
    'maxPromptBytes': 256 * 1024,
    'maxMembers': 12,
    'memberCalls': 8,
    'maxTurns': 40,
    'maxActorTurns': 12,
    'maxToolCalls': 120,
    'mailboxMessages': 64,
    'mailboxMessageBytes': 16 * 1024,
    'mailboxBytes': 256 * 1024,
    'runEvents': 1000,
    'sessionEvents': 4000,
    'eventRate': 20,
    'runDeadlineSec': 1800,
    'memberDeadlineSec': 480,
    'mailboxWaitSec': 600,
    'runTokens': 200000,
}
LIMIT_RANGES = {
    'maxPackageBytes': (1024 * 1024, 32 * 1024 * 1024),
    'maxFileBytes': (64 * 1024, 1024 * 1024),
    'maxFiles': (16, 512), 'maxDepth': (2, 8),
    'maxAgents': (1, 64), 'maxSkills': (0, 64), 'maxResources': (0, 256),
    'maxMetadataBytes': (4 * 1024, 64 * 1024),
    'maxResourceBytes': (4 * 1024, 256 * 1024),
    'maxPromptBytes': (1024, 256 * 1024),
    'maxMembers': (2, 12), 'memberCalls': (0, 8), 'maxTurns': (1, 40),
    'maxActorTurns': (1, 12), 'maxToolCalls': (1, 120),
    'mailboxMessages': (1, 64), 'mailboxMessageBytes': (1024, 16 * 1024),
    'mailboxBytes': (16 * 1024, 256 * 1024),
    'runEvents': (100, 1000), 'sessionEvents': (400, 4000), 'eventRate': (1, 20),
    'runDeadlineSec': (60, 1800), 'memberDeadlineSec': (60, 480),
    'mailboxWaitSec': (60, 600), 'runTokens': (1000, 200000),
}


class ExpertError(Exception):
    """Precise, non-secret package validation error."""

    def __init__(self, code, message, path=None, field=None, line=None, column=None, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.path = path
        self.field = field
        self.line = line
        self.column = column
        self.details = details

    def as_dict(self):
        error = {'code': self.code, 'message': self.message}
        for key, value in (('path', self.path), ('field', self.field), ('line', self.line),
                           ('column', self.column), ('details', self.details)):
            if value is not None:
                error[key] = value
        return {'ok': False, 'error': error}


def failure(code, message, **kwargs):
    raise ExpertError(code, message, **kwargs)


def error_response(error):
    if isinstance(error, ExpertError):
        return error.as_dict()
    return {'ok': False, 'error': {'code': 'EXPERT_INTERNAL', 'message': '专家包操作失败'}}
