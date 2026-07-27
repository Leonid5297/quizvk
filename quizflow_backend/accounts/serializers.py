from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers

User = get_user_model()


class UserSerializer(serializers.ModelSerializer):
    name = serializers.ReadOnlyField()
    linked_providers = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "username", "email", "role", "display_name", "name", "date_joined", "linked_providers"]
        read_only_fields = ["id", "username", "date_joined"]

    def get_linked_providers(self, obj):
        return list(obj.social_accounts.values_list("provider", flat=True))


class ProfileUpdateSerializer(serializers.ModelSerializer):
    """PATCH /api/auth/me/ — редактирование профиля (не пароль и не логин —
    для пароля отдельный ChangePasswordSerializer)."""

    class Meta:
        model = User
        fields = ["display_name", "email"]


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, validators=[validate_password])
    role = serializers.ChoiceField(choices=User.Role.choices, default=User.Role.PLAYER)

    class Meta:
        model = User
        fields = ["id", "username", "email", "password", "role", "display_name"]

    def create(self, validated_data):
        password = validated_data.pop("password")
        user = User(**validated_data)
        user.set_password(password)
        user.save()
        return user


class ChangePasswordSerializer(serializers.Serializer):
    old_password = serializers.CharField(write_only=True)
    new_password = serializers.CharField(write_only=True, validators=[validate_password])

    def validate_old_password(self, value):
        user = self.context["request"].user
        if not user.has_usable_password():
            raise serializers.ValidationError(
                "У аккаунта нет пароля — он создан через Google/VK. Сначала задайте пароль через сброс пароля."
            )
        if not user.check_password(value):
            raise serializers.ValidationError("Текущий пароль неверен.")
        return value


class PasswordResetRequestSerializer(serializers.Serializer):
    # Принимает email ИЛИ username — специально не сообщаем, найден ли
    # аккаунт: ответ всегда одинаковый, чтобы нельзя было перебором
    # проверить существование чужих email/логинов.
    email_or_username = serializers.CharField()


class PasswordResetConfirmSerializer(serializers.Serializer):
    uid = serializers.CharField()
    token = serializers.CharField()
    new_password = serializers.CharField(write_only=True, validators=[validate_password])
