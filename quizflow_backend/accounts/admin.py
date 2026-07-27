from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from .models import SocialAccount, User


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ("username", "email", "role", "display_name", "is_staff")
    fieldsets = BaseUserAdmin.fieldsets + (("QuizVK", {"fields": ("role", "display_name")}),)


@admin.register(SocialAccount)
class SocialAccountAdmin(admin.ModelAdmin):
    list_display = ("user", "provider", "provider_user_id", "created_at")
    list_filter = ("provider",)
    search_fields = ("user__username", "user__email", "provider_user_id")
