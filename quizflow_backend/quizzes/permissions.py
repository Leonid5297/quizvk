from rest_framework import permissions


class IsOwnerOrReadOnlyPublic(permissions.BasePermission):
    """Владелец может всё; остальные — только читать, и только если квиз публичный."""

    def has_object_permission(self, request, view, obj):
        if obj.owner_id == request.user.id:
            return True
        return request.method in permissions.SAFE_METHODS and obj.is_public
