""" Display wishlist stats from wishin.app """

load("render.star", "render")
load("http.star", "http")
load("encoding/base64.star", "base64")
load("cache.star", "cache")
load("encoding/json.star", "json")
load("schema.star", "schema")

DEFAULT_API_URL = "https://www.wishin.app/api/stats"

def main(config):
    """ This program is called by the device to render the screen.

    It uses the wishin.app API to fetch the data.
    It also uses the cache module to cache the data for 4 minutes.

    Returns:
        A render.Root object that will be rendered by the device.
    """

    api_url = config.str("api_url", DEFAULT_API_URL)

    cache_key = "stats:%s" % api_url
    stats_cached = cache.get(cache_key)
    if stats_cached != None:
        print("Cache hit!")
        stats = json.decode(stats_cached)
    else:
        print("Cache miss! Calling wishin.app API")
        rep = http.get(api_url)
        if rep.status_code != 200:
            fail("wishin.app API request failed with status %d", rep.status_code)
        stats = rep.json()
        cache.set(cache_key, json.encode(stats), ttl_seconds = 240)

    return render.Root(
        child = render.Column(
            expanded = True,
            main_align = "space_between",
            cross_align = "",
            children = [
                render.Row(
                    cross_align = "center",
                    children = [
                        render.Image(
                            src = GIFT_ICON,
                            width = 16,
                            height = 16,
                        ),
                        render.Column(
                            children = [
                                render.Marquee(width = 48, child = render.Text("%d gifts, %d claimed" % (stats["gifts"], stats["claimed"]), font = "Dina_r400-6")),
                            ],
                        ),
                    ],
                ),
                render.Row(
                    cross_align = "center",
                    children = [
                        render.Image(
                            src = KID_ICON,
                            width = 16,
                            height = 16,
                        ),
                        render.Column(
                            children = [
                                render.Text("%d users" % stats["users"], font = "Dina_r400-6"),
                            ],
                        ),
                    ],
                ),
            ],
        ),
    )

def get_schema():
    return schema.Schema(
        version = "1",
        fields = [
            schema.Text(
                id = "api_url",
                name = "API URL",
                desc = "wishin.app stats API endpoint.",
                icon = "globe",
                default = DEFAULT_API_URL,
            ),
        ],
    )

GIFT_ICON = base64.decode("""
iVBORw0KGgoAAAANSUhEUgAAARgAAAEYCAYAAACHjumMAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6
JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAaGVYSWZNTQAqAAAACAAEAQYAAwAAAAEA
AgAAARIAAwAAAAEAAQAAASgAAwAAAAEAAgAAh2kABAAAAAEAAAA+AAAAAAADoAEAAwAAAAEAAQAAoAIA
BAAAAAEAAAEYoAMABAAAAAEAAAEYAAAAAETEldIAAALkaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8
eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA2LjAuMCI+
CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3lu
dGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHht
bG5zOnRpZmY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vdGlmZi8xLjAvIgogICAgICAgICAgICB4bWxuczpl
eGlmPSJodHRwOi8vbnMuYWRvYmUuY29tL2V4aWYvMS4wLyI+CiAgICAgICAgIDx0aWZmOkNvbXByZXNz
aW9uPjE8L3RpZmY6Q29tcHJlc3Npb24+CiAgICAgICAgIDx0aWZmOlJlc29sdXRpb25Vbml0PjI8L3Rp
ZmY6UmVzb2x1dGlvblVuaXQ+CiAgICAgICAgIDx0aWZmOk9yaWVudGF0aW9uPjE8L3RpZmY6T3JpZW50
YXRpb24+CiAgICAgICAgIDx0aWZmOlBob3RvbWV0cmljSW50ZXJwcmV0YXRpb24+MjwvdGlmZjpQaG90
b21ldHJpY0ludGVycHJldGF0aW9uPgogICAgICAgICA8ZXhpZjpQaXhlbFhEaW1lbnNpb24+MjgwPC9l
eGlmOlBpeGVsWERpbWVuc2lvbj4KICAgICAgICAgPGV4aWY6Q29sb3JTcGFjZT4xPC9leGlmOkNvbG9y
U3BhY2U+CiAgICAgICAgIDxleGlmOlBpeGVsWURpbWVuc2lvbj4yODA8L2V4aWY6UGl4ZWxZRGltZW5z
aW9uPgogICAgICA8L3JkZjpEZXNjcmlwdGlvbj4KICAgPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KNbHG
qwAADLhJREFUeAHt3K+OJccVB+DdyMAvsEEeGhi02rBo6MpwmEPDogDDPEFgUFhw2EBr6cjMlpFfYY2c
FzDKRlGiq+tWz/ap9qlbfbo+o/unuv58p+e3benovnjhPwIECBAgQIAAAQIECBAgQIAAgd4CL3svUGX+
+/v7D1X2mrHPp6enIbWfzTlaq1H1iO5v77hf7b3QdQQIENgSEDBbQr4nQGC3gIDZTedCAgS2BATMlpDv
CRDYLSBgdtO5kACBLQEBsyXkewIEdgsImN10LiRAYEtAwGwJ+Z4Agd0CAmY3nQsJENgSGNLNubWpyPfZ
HaFf/eu7yLKHH/P5q9epe8zuMI3WTT3Wy5hdj/VV8j71BJNnaSYCBBYCAmYB4i0BAnkCAibP0kwECCwE
BMwCxFsCBPIEBEyepZkIEFgICJgFiLcECOQJCJg8SzMRILAQEDALEG8JEMgTEDB5lmYiQGAh8Mni/ene
nqUjNFqY6HmzO36jHbrRc2SPyz5v1Dk6Lnt/2X575/MEs1fOdQQIbAoImE0iAwgQ2CsgYPbKuY4AgU0B
AbNJZAABAnsFBMxeOdcRILApIGA2iQwgQGCvgIDZK+c6AgQ2BQTMJpEBBAjsFRAwe+VcR4DApsDpO3k3
BRoHjOq4jHaENh5nc3h2h272OUbVI7pu9nk3C3awAZ5gDlYQ2yFwJgEBc6ZqOguBgwkImIMVxHYInElA
wJypms5C4GACAuZgBbEdAmcSEDBnqqazEDiYgIA5WEFsh8CZBATMmarpLAQOJiBgDlYQ2yFwJgGdvEWq
md05Gu0wzV43yh1dNzpf9rioX/a61ebzBFOtYvZLoJCAgClULFslUE1AwFSrmP0SKCQgYAoVy1YJVBMQ
MNUqZr8ECgkImELFslUC1QQETLWK2S+BQgICplCxbJVANQEBU61i9kugkIBO3sZiRTs4j96J2njsmw8f
5RxdNwoSvQ+enp5eRuesNM4TTKVq2SuBYgICpljBbJdAJQEBU6la9kqgmICAKVYw2yVQSUDAVKqWvRIo
JiBgihXMdglUEhAwlaplrwSKCQiYYgWzXQKVBARMpWrZK4FiAofrHry/v/8wwjC7g3PEGXqs+f1P/w5N
+9tPc/+tiq4b2lzDoOxzRDt5G7YYGnqUzuDcuyJ0dIMIEJhFQMDMUmnnJDBAQMAMQLckgVkEBMwslXZO
AgMEBMwAdEsSmEVAwMxSaeckMEBAwAxAtySBWQQEzCyVdk4CAwQEzAB0SxKYReAXd/KO6rw9S4FGdRAf
vVN2VAfsWe6r7HPs7Qz2BJNdCfMRIHAREDAXCi8IEMgWEDDZouYjQOAiIGAuFF4QIJAtIGCyRc1HgMBF
QMBcKLwgQCBbQMBki5qPAIGLgIC5UHhBgEC2gIDJFjUfAQIXgWc7eUd16L57vLts7ogv3j68H7Ktv77/
NnXd6G/PRjtqR3UkR/cXxRt1/426r6Iu0XHLjl9PMFE54wgQaBYQMM1kLiBAICogYKJSxhEg0CwgYJrJ
XECAQFRAwESljCNAoFlAwDSTuYAAgaiAgIlKGUeAQLOAgGkmcwEBAlEBAROVMo4AgWaBw3XyNp/goBdk
d7aO+g3dv9y9SRWOdiRHO42jLtnnSEXpMFm0Izm7g1gnb4dimpIAgXUB/4u07uJTAgQSBARMAqIpCBBY
FxAw6y4+JUAgQUDAJCCaggCBdQEBs+7iUwIEEgQETAKiKQgQWBcQMOsuPiVAIEFAwCQgmoIAgXWBT9Y/
zv90VGdh9CTZnbfRdaOdqNH5sjtW//mPX4eW/uKPP4bGZe8v2hk8qr5n+c3gUHFXBnmCWUHxEQECOQIC
JsfRLAQIrAgImBUUHxEgkCMgYHIczUKAwIqAgFlB8REBAjkCAibH0SwECKwICJgVFB8RIJAjIGByHM1C
gMCKgIBZQfERAQI5Ajfr5I1uN9rxG50v+pujPz38KTTlp49/D42LDsrubI123kb3Fx2XvW60Mzi6v+xx
0fvlxdffZC9daj5PMKXKZbMEagkImFr1slsCpQQETKly2SyBWgICpla97JZAKQEBU6pcNkugloCAqVUv
uyVQSkDAlCqXzRKoJSBgatXLbgmUEhAwpcplswRqCRyuk3cUX7RDN9rB+TB5B+eoOj63bvS3j3/zhz8/
N8XPPo/eLy9evf7ZdbO98QQzW8Wdl8ANBQTMDbEtRWA2AQEzW8Wdl8ANBQTMDbEtRWA2AQEzW8Wdl8AN
BQTMDbEtRWA2AQEzW8Wdl8ANBQTMDbEtRWA2AQEzW8Wdl8ANBXTyNmIfvYPz6L9l28i9OTz6m8aPv//d
5lz/HRCub2g2gzzBuAcIEOgmIGC60ZqYAAEB4x4gQKCbgIDpRmtiAgQEjHuAAIFuAgKmG62JCRAQMO4B
AgS6CQiYbrQmJkBAwLgHCBDoJqCTtxtt7sTvHu9CE759eB8ad/RB2eeN/kbyV0eHKbY/TzDFCma7BCoJ
CJhK1bJXAsUEBEyxgtkugUoCAqZSteyVQDEBAVOsYLZLoJKAgKlULXslUExAwBQrmO0SqCQgYCpVy14J
FBMQMMUKZrsEKgno5G2s1uevXjdecdvh0Q7Y6K6yO4Oz9xedL/scR78PovXtPc4TTG9h8xOYWEDATFx8
RyfQW0DA9BY2P4GJBQTMxMV3dAK9BQRMb2HzE5hYQMBMXHxHJ9BbQMD0FjY/gYkFBMzExXd0Ar0FBExv
YfMTmFhAJ2+n4v/th29DM3/52ZvQOINqCsx+H3iCqXnf2jWBEgICpkSZbJJATQEBU7Nudk2ghICAKVEm
myRQU0DA1KybXRMoISBgSpTJJgnUFBAwNetm1wRKCAiYEmWySQI1BQRMzbrZNYESAjp5/18mv7Fa4n7t
vkn3QS6xJ5hcT7MRIHAlIGCuMLwkQCBXQMDkepqNAIErAQFzheElAQK5AgIm19NsBAhcCQiYKwwvCRDI
FRAwuZ5mI0DgSkDAXGF4SYBAroCAyfU0GwECVwKn7+R993h3ddznX759eP/8l1ffRH9j9eoSLw8g4D4Y
UwRPMGPcrUpgCgEBM0WZHZLAGAEBM8bdqgSmEBAwU5TZIQmMERAwY9ytSmAKAQEzRZkdksAYAQEzxt2q
BKYQEDBTlNkhCYwREDBj3K1KYAoBATNFmR2SwBgBATPG3aoEphAQMFOU2SEJjBEQMGPcrUpgCgEBM0WZ
HZLAGAEBM8bdqgSmEBAwU5TZIQmMERAwY9ytSmAKAQEzRZkdksAYAQEzxt2qBKYQuNlv8kZ/8zb626lT
VMchCewUiP697Zw+fJknmDCVgQQItAoImFYx4wkQCAsImDCVgQQItAoImFYx4wkQCAsImDCVgQQItAoI
mFYx4wkQCAsImDCVgQQItAoImFYx4wkQCAsImDCVgQQItAo828n79PT0MjLZ/f39h8i46JjsDkSdwVF5
4yoIZP99RM8czYPlfJ5gliLeEyCQJiBg0ihNRIDAUkDALEW8J0AgTUDApFGaiACBpYCAWYp4T4BAmoCA
SaM0EQECSwEBsxTxngCBNAEBk0ZpIgIElgICZiniPQECaQLPdvJGV9jb4ffc/EfvDH5u3z6fS+DLz94c
+sDZf5d7D+sJZq+c6wgQ2BQQMJtEBhAgsFdAwOyVcx0BApsCAmaTyAACBPYKCJi9cq4jQGBTQMBsEhlA
gMBeAQGzV851BAhsCgiYTSIDCBDYKyBg9sq5jgCBTYFf3Mm7uULjgOwOxOzO4KN3cDZyTzN81G/ZRoGz
7/vour3HeYLpLWx+AhMLCJiJi+/oBHoLCJjewuYnMLGAgJm4+I5OoLeAgOktbH4CEwsImImL7+gEegsI
mN7C5icwsYCAmbj4jk6gt4CA6S1sfgITC7yc+Oy7jp7dGbxrEx+56N3j3Ue+bf8quwM2ur/sddtP/vEr
ztp5+/FTt3/rCabdzBUECAQFBEwQyjACBNoFBEy7mSsIEAgKCJgglGEECLQLCJh2M1cQIBAUEDBBKMMI
EGgXEDDtZq4gQCAoIGCCUIYRINAuIGDazVxBgEBQQCdvEKrXsKN3Bvc6963n1Xl7a/H/recJZoy7VQlM
ISBgpiizQxIYIyBgxrhblcAUAgJmijI7JIExAgJmjLtVCUwhIGCmKLNDEhgjIGDGuFuVwBQCAmaKMjsk
gTECAmaMu1UJTCGgk/dkZT5LZ7DO23PcmJ5gzlFHpyBwSAEBc8iy2BSBcwgImHPU0SkIHFJAwByyLDZF
4BwCAuYcdXQKAocUEDCHLItNETiHgIA5Rx2dgsAhBQTMIctiUwTOISBgzlFHpyBAgAABAgQIECBAgAAB
AgQIECBAgAABAgQIECBAgEARgf8AcskIf0f5WasAAAAASUVORK5CYII=
""")

KID_ICON = base64.decode("""
iVBORw0KGgoAAAANSUhEUgAAAE8AAABPCAYAAACqNJiGAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6
JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAkGVYSWZNTQAqAAAACAAGAQYAAwAAAAEA
AgAAARIAAwAAAAEAAQAAARoABQAAAAEAAABWARsABQAAAAEAAABeASgAAwAAAAEAAgAAh2kABAAAAAEA
AABmAAAAAAAAAEgAAAABAAAASAAAAAEAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAT6ADAAQAAAABAAAA
TwAAAAC52TaTAAAACXBIWXMAAAsTAAALEwEAmpwYAAADRmlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAA
PHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iWE1QIENvcmUgNi4wLjAi
PgogICA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5
bnRheC1ucyMiPgogICAgICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgICAgICAgICB4
bWxuczp0aWZmPSJodHRwOi8vbnMuYWRvYmUuY29tL3RpZmYvMS4wLyIKICAgICAgICAgICAgeG1sbnM6
ZXhpZj0iaHR0cDovL25zLmFkb2JlLmNvbS9leGlmLzEuMC8iPgogICAgICAgICA8dGlmZjpDb21wcmVz
c2lvbj4xPC90aWZmOkNvbXByZXNzaW9uPgogICAgICAgICA8dGlmZjpSZXNvbHV0aW9uVW5pdD4yPC90
aWZmOlJlc29sdXRpb25Vbml0PgogICAgICAgICA8dGlmZjpYUmVzb2x1dGlvbj43MjwvdGlmZjpYUmVz
b2x1dGlvbj4KICAgICAgICAgPHRpZmY6WVJlc29sdXRpb24+NzI8L3RpZmY6WVJlc29sdXRpb24+CiAg
ICAgICAgIDx0aWZmOk9yaWVudGF0aW9uPjE8L3RpZmY6T3JpZW50YXRpb24+CiAgICAgICAgIDx0aWZm
OlBob3RvbWV0cmljSW50ZXJwcmV0YXRpb24+MjwvdGlmZjpQaG90b21ldHJpY0ludGVycHJldGF0aW9u
PgogICAgICAgICA8ZXhpZjpQaXhlbFhEaW1lbnNpb24+NjMyPC9leGlmOlBpeGVsWERpbWVuc2lvbj4K
ICAgICAgICAgPGV4aWY6Q29sb3JTcGFjZT4xPC9leGlmOkNvbG9yU3BhY2U+CiAgICAgICAgIDxleGlm
OlBpeGVsWURpbWVuc2lvbj42MzI8L2V4aWY6UGl4ZWxZRGltZW5zaW9uPgogICAgICA8L3JkZjpEZXNj
cmlwdGlvbj4KICAgPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KoQ9/mwAAC+ZJREFUeAHtXE2MHEcVru6e
n13vj/cHx2INUUiEwCwWERIEbljIB4OAXMw5JxTDPRI33+GKzA1LOQCyhAAJGREiQAKF5IIQcYJAYEsh
lhw73qztdXZ2+ofve9XVXdMz3dM/s9611WVNd3X1e6/e++rVe1Xd7VWqLbURcCpwkjY6e/a55WCw80qk
nDVc+5FSVWSQGCyq46jojtdfOHPlyut3cS2ycX6kSqeqtq77wPOVc6rjufNhRByqF9dxlB+EH1JWde7D
w1EZPLUN5XvqQRCE84AugCPBa8o6H8F2AHlE0B6IrMODRWVNqoCXTC1U4DyYeFHkOgqV0gU8RJss4LXY
EtlW26GvVgFP5igdjy5ngldVC8kqPxwoKy5seuSKPfqllD8KKuNrFVwukW14KIOyHuVibLFtYNtYVgXK
zi6C1UY38l58Kni67yovpL9MkmBLy9bBg7muBqEKfnzd+++NoRPMYe4jeB5IgSq0olb2z5222axKg93Q
UZ4bqZWer/oI+TWTrXjuIFCe57qfdCHYhUwx4UDgkwBeK/vngjeWVZ3ICQBeAHfzQ+ViqFRY01hiBRmQ
FYaUGQI58eKp8tCpoMwzC53GtElD5mDuFdHXz/754Gk1XHETZkadI0VZiXnQx6HudQp5xR6HDg0M5DhV
kqayaXUdC/aJvCXpa2f/aeBNVEoa6wJHZouXVetSROcdytIZ/jL0pn+eq2b/ytnWKDarM71jst/Mqodi
OXbfVbN/fc/L6MSt2o1bHzCOJWBwNJEU1MaxFa6qRzg8+NvzC7fUEMFPFs0jd0cvkORFzsefWMFZFtpC
QImMwe+8Z/rVfVSkh2aI48pd/uXO+uunT58Kusj+0J3qF2bhmYHHrgZ7eyoIggQM7ECQUpmWoYaFnblc
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
""")
