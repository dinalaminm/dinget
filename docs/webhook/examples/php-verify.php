<?php
/**
 * SellPoint ওয়েবহুক যাচাই — PHP 7.4+ (কোনো লাইব্রেরি লাগে না)
 *
 * ব্যবহার (webhook.php):
 *   $raw = file_get_contents('php://input');   // হুবহু বডি — json_decode করে আবার encode করবেন না
 *   $header = $_SERVER['HTTP_X_DINGET_SIGNATURE'] ?? '';
 *   [$ok, $reason] = sellpoint_verify($raw, $header, $secret);
 *   if (!$ok) { http_response_code(401); exit($reason); }
 */

const SELLPOINT_TOLERANCE_SEC = 300; // ৫ মিনিটের বেশি পুরনো/ভবিষ্যতের কল বাতিল — replay ঠেকাতে

function sellpoint_verify(string $rawBody, ?string $header, string $secret, ?int $nowSec = null, int $toleranceSec = SELLPOINT_TOLERANCE_SEC): array
{
    if ($secret === '') return [false, 'no_secret'];
    $nowSec = $nowSec ?? time();

    $parts = [];
    foreach (explode(',', (string)$header) as $piece) {
        $pos = strpos($piece, '=');
        if ($pos !== false && $pos > 0) {
            $parts[trim(substr($piece, 0, $pos))] = trim(substr($piece, $pos + 1));
        }
    }
    $t  = $parts['t']  ?? '';
    $v1 = $parts['v1'] ?? '';
    if (!preg_match('/^\d+$/', $t) || !preg_match('/^[0-9a-fA-F]{64}$/', $v1)) return [false, 'malformed_header'];

    if (abs($nowSec - (int)$t) > $toleranceSec) return [false, 'stale_timestamp'];

    $expected = hash_hmac('sha256', $t . '.' . $rawBody, $secret);
    if (!hash_equals($expected, strtolower($v1))) return [false, 'bad_signature'];

    return [true, null];
}
