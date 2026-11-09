package com.la.exception;

import com.la.dto.ApiResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(BizException.class)
    public ResponseEntity<ApiResponse<Void>> handleBiz(BizException e) {
        return ResponseEntity.badRequest().body(ApiResponse.fail(e.getCode(), e.getMessage()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResponse<Void>> handleValid(MethodArgumentNotValidException e) {
        FieldError fe = e.getBindingResult().getFieldError();
        String msg = fe == null ? "参数校验失败" : fe.getDefaultMessage();
        return ResponseEntity.badRequest().body(ApiResponse.fail(400, msg));
    }

    // 404 回归 404：Spring Boot 3.2+ 不存在的路径抛 NoResourceFoundException，
    // 若落入下方 Exception 兜底会被误报成 500「服务器开小差了」，掩盖前端路径拼接错误
    @ExceptionHandler(org.springframework.web.servlet.resource.NoResourceFoundException.class)
    public ResponseEntity<ApiResponse<Void>> handleNotFound(org.springframework.web.servlet.resource.NoResourceFoundException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(ApiResponse.fail(404, "请求的接口不存在 (" + e.getResourcePath() + ")"));
    }

    // 客户端请求错误回归 400：缺少必填参数 / 路径参数类型不匹配 / 请求体不可读，
    // 均为客户端问题，落入 500 兜底会污染错误日志并误导排障
    @ExceptionHandler(org.springframework.web.bind.MissingServletRequestParameterException.class)
    public ResponseEntity<ApiResponse<Void>> handleMissingParam(org.springframework.web.bind.MissingServletRequestParameterException e) {
        return ResponseEntity.badRequest().body(ApiResponse.fail(400, "缺少必填参数: " + e.getParameterName()));
    }

    @ExceptionHandler(org.springframework.web.method.annotation.MethodArgumentTypeMismatchException.class)
    public ResponseEntity<ApiResponse<Void>> handleTypeMismatch(org.springframework.web.method.annotation.MethodArgumentTypeMismatchException e) {
        return ResponseEntity.badRequest().body(ApiResponse.fail(400, "参数类型错误: " + e.getName()));
    }

    @ExceptionHandler(org.springframework.http.converter.HttpMessageNotReadableException.class)
    public ResponseEntity<ApiResponse<Void>> handleNotReadable(org.springframework.http.converter.HttpMessageNotReadableException e) {
        return ResponseEntity.badRequest().body(ApiResponse.fail(400, "请求体格式错误，请提交合法 JSON"));
    }

    // 数据库唯一约束冲突（如并发重复提交撞唯一键）返回 400 友好提示，而非 500
    @ExceptionHandler(org.springframework.dao.DuplicateKeyException.class)
    public ResponseEntity<ApiResponse<Void>> handleDuplicateKey(org.springframework.dao.DuplicateKeyException e) {
        return ResponseEntity.badRequest().body(ApiResponse.fail(400, "操作已存在，请勿重复提交，稍后刷新查看结果"));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> handleOther(Exception e) {
        log.error("未处理异常", e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(ApiResponse.fail(500, "服务器开小差了，请稍后再试"));
    }
}
