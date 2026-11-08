package com.la.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.la.entity.ClassCoTeacher;
import com.la.entity.ClassEntity;
import com.la.entity.User;
import com.la.exception.BizException;
import com.la.mapper.ClassCoTeacherMapper;
import com.la.mapper.ClassMapper;
import com.la.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.stream.Collectors;

/**
 * 班级共同管理教师（co-teacher）：
 * - 仅班级所有者可添加共同管理者；共同管理教师列表为纯展示，不提供移除入口；
 * - 权限仅作用于指定班级（class_co_teacher 按 class_id 隔离），不影响其他班级；
 * - 班级维度的学情/学生/预警/作业查询本身按 classId 直查，教师出现在
 *   /teacher/classes 返回的共同管理班级中即可查看对应数据。
 */
@Service
@RequiredArgsConstructor
public class CoTeacherService {

    private final ClassCoTeacherMapper coTeacherMapper;
    private final ClassMapper classMapper;
    private final UserMapper userMapper;

    /** 面板数据：班级信息 + 已关联教师列表 + 可添加候选（实时拉取） */
    public Map<String, Object> panel(Long classId, Long currentTeacherId) {
        ClassEntity cls = requireClass(classId);
        User owner = userMapper.selectById(cls.getTeacherId());
        boolean manageable = cls.getTeacherId().equals(currentTeacherId);

        List<Map<String, Object>> coTeachers = coTeacherList(classId);
        List<Map<String, Object>> candidates = manageable ? candidates(cls, coTeachers) : List.of();

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("classId", cls.getId());
        m.put("className", cls.getName());
        m.put("owner", owner != null ? owner.getRealName() : "未知");
        m.put("manageable", manageable);
        m.put("coTeachers", coTeachers);
        m.put("candidates", candidates);
        return m;
    }

    /** 添加共同管理教师：仅所有者可操作；目标须为系统内有效教师账号且未重复 */
    public Map<String, Object> add(Long classId, Long currentTeacherId, Long teacherId) {
        ClassEntity cls = requireClass(classId);
        if (!cls.getTeacherId().equals(currentTeacherId)) {
            throw new BizException("仅班级所有者可以添加共同管理教师");
        }
        if (teacherId == null) {
            throw new BizException("请选择要添加的教师");
        }
        if (teacherId.equals(cls.getTeacherId())) {
            throw new BizException("不能添加班级所有者本人");
        }
        User target = userMapper.selectById(teacherId);
        if (target == null || !"TEACHER".equals(target.getRole())) {
            throw new BizException("目标账号不存在或不是教师账号");
        }
        Long dup = coTeacherMapper.selectCount(new LambdaQueryWrapper<ClassCoTeacher>()
                .eq(ClassCoTeacher::getClassId, classId)
                .eq(ClassCoTeacher::getTeacherId, teacherId));
        if (dup > 0) {
            throw new BizException("教师「" + target.getRealName() + "」已在共同管理列表中，请勿重复添加");
        }
        ClassCoTeacher row = new ClassCoTeacher();
        row.setClassId(classId);
        row.setTeacherId(teacherId);
        coTeacherMapper.insert(row);
        return panel(classId, currentTeacherId);
    }

    /** 教师可见班级 = 授课班级 + 共同管理班级（去重；供 /teacher/classes 联合返回） */
    public List<Long> coManagedClassIds(Long teacherId) {
        return coTeacherMapper.selectList(new LambdaQueryWrapper<ClassCoTeacher>()
                        .eq(ClassCoTeacher::getTeacherId, teacherId))
                .stream().map(ClassCoTeacher::getClassId).distinct().toList();
    }

    private ClassEntity requireClass(Long classId) {
        if (classId == null) {
            throw new BizException("缺少班级参数");
        }
        ClassEntity cls = classMapper.selectById(classId);
        if (cls == null) {
            throw new BizException("班级不存在");
        }
        return cls;
    }

    private List<Map<String, Object>> coTeacherList(Long classId) {
        List<ClassCoTeacher> rows = coTeacherMapper.selectList(new LambdaQueryWrapper<ClassCoTeacher>()
                .eq(ClassCoTeacher::getClassId, classId).orderByAsc(ClassCoTeacher::getCreatedAt));
        if (rows.isEmpty()) {
            return List.of();
        }
        Map<Long, User> byId = userMapper.selectBatchIds(
                        rows.stream().map(ClassCoTeacher::getTeacherId).toList())
                .stream().collect(Collectors.toMap(User::getId, u -> u));
        return rows.stream().map(r -> {
            User u = byId.get(r.getTeacherId());
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.getId());
            m.put("teacherId", r.getTeacherId());
            m.put("realName", u != null ? u.getRealName() : "未知");
            m.put("username", u != null ? u.getUsername() : "");
            m.put("addedAt", r.getCreatedAt() != null
                    ? r.getCreatedAt().toLocalDate().toString() : "");
            return m;
        }).toList();
    }

    /** 候选 = 系统内全部教师 − 所有者 − 已添加 */
    private List<Map<String, Object>> candidates(ClassEntity cls, List<Map<String, Object>> coTeachers) {
        Set<Long> excluded = new HashSet<>();
        excluded.add(cls.getTeacherId());
        coTeachers.forEach(m -> excluded.add((Long) m.get("teacherId")));
        return userMapper.selectList(new LambdaQueryWrapper<User>()
                        .eq(User::getRole, "TEACHER").orderByAsc(User::getId))
                .stream()
                .filter(u -> !excluded.contains(u.getId()))
                .map(u -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", u.getId());
                    m.put("realName", u.getRealName());
                    m.put("username", u.getUsername());
                    return m;
                }).toList();
    }
}
