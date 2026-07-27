import random
import string


def generate_room_code(length=6):
    alphabet = string.ascii_uppercase + string.digits
    # Убираем визуально спутываемые символы (0/O, 1/I) — код диктуют вслух.
    alphabet = alphabet.translate({ord(c): None for c in "0O1I"})
    return "".join(random.choice(alphabet) for _ in range(length))
